// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {exec} from 'child_process';
import * as fs from 'fs-plus';
import * as _ from 'lodash';
import * as opn from 'opn';
import * as os from 'os';
import * as vscode from 'vscode';
import * as WinReg from 'winreg';
import * as sdk from 'vscode-iot-device-cube-sdk';
import * as path from 'path';
import * as utils from '../utils';

import {BoardProvider} from '../boardProvider';
import {ConfigHandler} from '../configHandler';
import {ConfigKey, ScaffoldType} from '../constants';
import {DialogResponses} from '../DialogResponses';

import {ScaffoldGenerator} from './ScaffoldGenerator';
import {ArduinoDeviceBase} from './ArduinoDeviceBase';
import {DeviceType} from './Interfaces/Device';
import {TemplateFileInfo, ProjectTemplateType} from './Interfaces/ProjectTemplate';

const impor = require('impor')(__dirname);
const forEach = impor('lodash.foreach') as typeof import('lodash.foreach');
const trimStart =
    impor('lodash.trimstart') as typeof import('lodash.trimstart');

interface SerialPortInfo {
  comName: string;
  manufacturer: string;
  vendorId: string;
  productId: string;
}

const constants = {
  boardInfo: 'AZ3166:stm32f4:MXCHIP_AZ3166',
  uploadMethod: 'upload_method=OpenOCDMethod',
  outputPath: './.build',
  platformLocalFileName: 'platform.local.txt',
  cExtraFlag: 'compiler.c.extra_flags=-DCORRELATIONID="',
  cppExtraFlag: 'compiler.cpp.extra_flags=-DCORRELATIONID="',
  traceExtraFlag: ' -DENABLETRACE=',
  informationPageUrl: 'https://aka.ms/AA35xln',
  binFileExt: '.bin',
  otaBinFileExt: '.ota.bin'
};

enum configDeviceOptions {
  ConnectionString,
  UDS
}

async function cmd(command: string) {
  exec(command, Promise.resolve);
}

export class AZ3166Device extends ArduinoDeviceBase {
  private static _boardId = 'devkit';
  name = 'AZ3166';

  // tslint:disable-next-line: no-any
  private static _registerCallback: any;

  private static _monitorCallbackCommandName: string;

  private templateFolderPath: string;

  constructor(
      context: vscode.ExtensionContext, channel: vscode.OutputChannel,
      projectPath: string, projectTemplateType: ProjectTemplateType, private templateFilesInfo: TemplateFileInfo[] = []) {
    super(context, projectPath, channel, DeviceType.MXChip_AZ3166, projectTemplateType);
    this.templateFolderPath =
        path.join(this.boardFolderPath, AZ3166Device.boardId);
  }

  static async registerGetMonitorCallbackCommand() {
    AZ3166Device._monitorCallbackCommandName = `iotworkbench.monitorSerialport${new Date().getTime()}_${Math.round(
      Math.random() * 100
    )}`
    try {
      if(!AZ3166Device._registerCallback) {
        AZ3166Device._registerCallback = await vscode.commands.registerCommand(
          'iotworkbench.getMonitorCallbackCommandName',
          () => {
            return AZ3166Device._monitorCallbackCommandName;
          }
        );
      }
    } catch (err) {
      throw err;
    }
  }

  static get boardId() {
    return AZ3166Device._boardId;
  }

  get id() {
    return this.componentId;
  }

  get board() {
    const boardProvider = new BoardProvider(this.boardFolderPath);
    const az3166 = boardProvider.find({id: AZ3166Device._boardId});
    return az3166;
  }
  
  async compile(): Promise<boolean> {
    try {
      const res = await super.compile();
      if (!res) {
        return false;
      }
    } catch (error) {
      throw new Error(`Failed to compile AZ3166 device code using arduino-cli. Error message: ${error.message}`);
    }

    try {
      await this.generateBinFile();
    } catch (error) {
      throw new Error(`Failed to generate bin file for DevKit bootloader. Error message: ${error.message}`);
    }

    vscode.window.showInformationMessage('DevKit device code compilation succeeded.');

    return true;
  }

  async upload(): Promise<boolean> {
    const res = await super.upload();
    if (!res) {
      return false;
    }

    if (!fs.existsSync(this.outputPath)) {
      const message = `Output path ${this.outputPath} does not exist. Please compile device code first.`;
      await vscode.window.showWarningMessage(message);
      return false;
    }

    const binFiles = fs.readdirSync(this.outputPath).filter(
        file => path.extname(file).endsWith(constants.binFileExt) && !path.basename(file).endsWith(constants.otaBinFileExt));
      if (!binFiles || !binFiles.length) {
        const message = `No bin file found. Please compile device code first.`;
        await vscode.window.showWarningMessage(message);
        return false;
      }

    let hostVolumes;
    try {
      hostVolumes = await sdk.FileSystem.listVolume();
    } catch (error) {
      throw new Error(`List host volume failed. Error message: ${error.message}`);
    }

    const az3166Disk = hostVolumes.find(volume => volume.name === "AZ3166");
    if (!az3166Disk) {
      const message = 'No AZ3166 device found. Please plug in a devkit board.';
      vscode.window.showWarningMessage(message);
      throw new Error(message);
    }
    const binFilePath = path.join(this.outputPath, binFiles[0]);
    try {
      await sdk.FileSystem.transferFile(binFilePath, az3166Disk.path);
    } catch (error) {
      throw new Error(`Copy bin file to AZ3166 board failed. ${error.message}`);
    }

    const message = `Successfully deploy bin file to AZ3166 board.`;
    this.channel.show();
    this.channel.appendLine(message);
    vscode.window.showInformationMessage(message);

    return true;
  }

  private async generateBinFile(): Promise<boolean> {
    if (!fs.existsSync(this.outputPath)) {
      throw new Error(`Output path ${this.outputPath} does not exist`);
    }

    let binFiles;
    try {
      binFiles = fs.readdirSync(this.outputPath).filter(
        file => path.extname(file).endsWith(constants.binFileExt));
    } catch (error) {
      throw new Error(`Failed to get bin Files from directory ${this.outputPath}.`);
    }

    if (binFiles && binFiles[0]) {
      try {
        const binFilePath = path.join(this.outputPath, binFiles[0]);
        const appbin = fs.readFileSync(binFilePath, 'binary');
        // Temperately hard-code AZ3166 version
        const az3166Version = '1.6.2';
        const bootBinFilePath = path.join('/root/.arduino15/packages/AZ3166/hardware/stm32f4', az3166Version, 'bootloader/boot.bin');
        if (!fs.existsSync(bootBinFilePath)) {
          throw new Error(`Cannot find the boot bin file: ${bootBinFilePath}.`);
        }
        const bootBin = fs.readFileSync(bootBinFilePath, 'binary');
        const fileContent = bootBin + '\xFF'.repeat(0xc000-bootBin.length) + appbin;

        fs.writeFileSync(binFilePath, fileContent, 'binary');
        fs.writeFileSync(binFilePath.replace(`${constants.binFileExt}`, `${constants.otaBinFileExt}`), appbin, 'binary');
      } catch (error) {
        throw new Error(`Failed to generate ${constants.binFileExt} file and ${constants.otaBinFileExt} file. Error message: ${error.message}`);
      }
    } else {
      throw new Error(`Cannot find the bin File under directory ${this.outputPath}. Please compile code first.`);
    }

    this.channel.show();
    this.channel.appendLine(`Successfully Generated binary file.`);
    return true;
  }

  async load(): Promise<boolean> {
    if (!this.board) {
      throw new Error('Unable to find the board in the config file.');
    }

    try {
      const scaffoldGenerator = new ScaffoldGenerator();
      await scaffoldGenerator.scaffoldIoTProjectFiles(ScaffoldType.Workspace, this.projectFolder, this.vscodeFolderPath,
        this.devcontainerFolderPath, this.templateFolderPath, this.projectType);
    } catch(error) {
      throw new Error(`Failed to scaffold IoT Project files when loading AZ3166 device project. Error message: ${error}`);
    }

    return true;
  }

  async create(): Promise<boolean> {
    if (!this.board) {
      throw new Error('Unable to find the board in the config file.');
    }

    try {
      const scaffoldGenerator = new ScaffoldGenerator();
      await scaffoldGenerator.scaffoldIoTProjectFiles(ScaffoldType.Local, this.projectFolder, this.vscodeFolderPath,
        this.devcontainerFolderPath, this.templateFolderPath, this.projectType);
      await this.generateSketchFile(this.templateFilesInfo);
    } catch (error) {
      throw new Error(`Failed to scaffold IoT Project files when creating AZ3166 device. Error message: ${error}`);
    }
    return true;
  }

  async preUploadAction(): Promise<boolean> {
    return true;
  }

  async configDeviceSettings(): Promise<boolean> {
    const configSelectionItems: vscode.QuickPickItem[] = [
      {
        label: 'Config Device Connection String',
        description: 'Config Device Connection String',
        detail: 'Config Connection String'
      },
      {
        label: 'Config Unique Device String (UDS)',
        description: 'Config Unique Device String (UDS)',
        detail: 'Config UDS'
      },
      {
        label: 'Generate CRC for OTA',
        description:
            'Generate Cyclic Redundancy Check(CRC) code for OTA Update',
        detail: 'Config CRC'
      }
    ];

    const configSelection =
        await vscode.window.showQuickPick(configSelectionItems, {
          ignoreFocusOut: true,
          matchOnDescription: true,
          matchOnDetail: true,
          placeHolder: 'Select an option',
        });

    if (!configSelection) {
      return false;
    }

    if (configSelection.detail === 'Config CRC') {
      const retValue: boolean =
          await this.generateCrc(this.extensionContext, this.channel);
      return retValue;
    } else if (configSelection.detail === 'Config Connection String') {
      try {
        // Get IoT Hub device connection string from config
        let deviceConnectionString =
            ConfigHandler.get<string>(ConfigKey.iotHubDeviceConnectionString);

        let hostName = '';
        let deviceId = '';
        if (deviceConnectionString) {
          const hostnameMatches =
              deviceConnectionString.match(/HostName=(.*?)(;|$)/);
          if (hostnameMatches) {
            hostName = hostnameMatches[0];
          }

          const deviceIDMatches =
              deviceConnectionString.match(/DeviceId=(.*?)(;|$)/);
          if (deviceIDMatches) {
            deviceId = deviceIDMatches[0];
          }
        }

        let deviceConnectionStringSelection: vscode.QuickPickItem[] = [];
        if (deviceId && hostName) {
          deviceConnectionStringSelection = [
            {
              label: 'Select IoT Hub Device Connection String',
              description: '',
              detail: `Device Information: ${hostName} ${deviceId}`
            },
            {
              label: 'Input IoT Hub Device Connection String',
              description: '',
              detail: ''
            }
          ];
        } else {
          deviceConnectionStringSelection = [{
            label: 'Input IoT Hub Device Connection String',
            description: '',
            detail: ''
          }];
        }

        const selection = await vscode.window.showQuickPick(
            deviceConnectionStringSelection,
            {ignoreFocusOut: true, placeHolder: 'Choose an option:'});

        if (!selection) {
          return false;
        }

        if (selection.label === 'Input IoT Hub Device Connection String') {
          const option: vscode.InputBoxOptions = {
            value:
                'HostName=<Host Name>;DeviceId=<Device Name>;SharedAccessKey=<Device Key>',
            prompt: `Please input device connection string here.`,
            ignoreFocusOut: true,
            validateInput: (deviceConnectionString: string) => {
              if (!deviceConnectionString) {
                return 'Please provide a valid device connection string.';
              }

              if ((deviceConnectionString.indexOf('HostName') === -1) ||
                  (deviceConnectionString.indexOf('DeviceId') === -1) ||
                  (deviceConnectionString.indexOf('SharedAccessKey') === -1)) {
                return 'The format of the IoT Hub Device connection string is invalid.';
              }
              return;
            }
          };

          deviceConnectionString = await vscode.window.showInputBox(option);
          if (!deviceConnectionString) {
            const message =
                'Need more information on how to get device connection string?';
            const result: vscode.MessageItem|undefined =
                await vscode.window.showWarningMessage(
                    message, DialogResponses.yes, DialogResponses.no);
            if (result === DialogResponses.yes) {
              opn(constants.informationPageUrl);
            }
            return false;
          }
        }

        if (!deviceConnectionString) {
          return false;
        }

        console.log(deviceConnectionString);

        // Try to close serial monitor
        try {
          await vscode.commands.executeCommand('arduino.closeSerialMonitor');
        } catch (ignore) {
        }

        // Set selected connection string to device
        let res: boolean;
        const plat = await sdk.SerialPort.getPlatform();
        if (plat === 'win32') {
          res = await this.flushDeviceConfig(
            deviceConnectionString, configDeviceOptions.ConnectionString);
        } else {
          res = await this.flushDeviceConfigUnix(
            deviceConnectionString, configDeviceOptions.ConnectionString);
        }

        if (res === false) {
          return false;
        } else {
          vscode.window.showInformationMessage(
              'Configure Device connection string completely.');
          return true;
        }
      } catch (error) {
        throw error;
      }
    } else {
      try {
        function generateRandomHex(): string {
          const chars = '0123456789abcdef'.split('');
          let hexNum = '';
          for (let i = 0; i < 64; i++) {
            hexNum += chars[Math.floor(Math.random() * 16)];
          }
          return hexNum;
        }

        const option: vscode.InputBoxOptions = {
          value: generateRandomHex(),
          prompt: `Please input Unique Device String (UDS) here.`,
          ignoreFocusOut: true,
          validateInput: (UDS: string) => {
            if (/^([0-9a-f]){64}$/i.test(UDS) === false) {
              return 'The format of the UDS is invalid. Please provide a valid UDS.';
            }
            return '';
          }
        };

        const UDS = await vscode.window.showInputBox(option);

        if (UDS === undefined) {
          return false;
        }

        console.log(UDS);

        // Try to close serial monitor
        try {
          await vscode.commands.executeCommand('arduino.closeSerialMonitor');
        } catch (ignore) {
        }

        // Set selected connection string to device
        let res: boolean;
        const plat = await sdk.SerialPort.getPlatform();
        if (plat === 'win32') {
          res = await this.flushDeviceConfig(UDS, configDeviceOptions.UDS);
        } else {
          res = await this.flushDeviceConfigUnix(UDS, configDeviceOptions.UDS);
        }

        if (res === false) {
          return false;
        } else {
          vscode.window.showInformationMessage(
              'Configure Unique Device String (UDS) completely.');
          return true;
        }
      } catch (error) {
        throw error;
      }
    }
  }

  async flushDeviceConfigUnix(configValue: string, option: number):
      Promise<boolean> {
    return new Promise(
        async (
            resolve: (value: boolean) => void,
            reject: (value: Error) => void
        ) => {
          let comPort = '';
          let command = '';
          try {
            // Choose COM port that AZ3166 is connected
            const comPortListJson = await sdk.SerialPort.getComList();
            const comList: Array<Object> = JSON.parse(JSON.stringify(comPortListJson))["portList"];
            
            comPort = await this.chooseCOM(comList);
            console.log(`Opening ${comPort}.`);
          } catch (error) {
            reject(error);
          }
          if (option === configDeviceOptions.ConnectionString) {
            command = 'set_az_iothub';
          } else {
            command = 'set_dps_uds';
          }
          let errorRejected = false;

          const az3166 = this.board;

          if (!az3166) {
            return reject(
                new Error('IoT DevKit is not found in the board list.'));
          }

          const rejectIfError = (err: Error) => {
            if (errorRejected) return true;
            if (err) {
              errorRejected = true;
              reject(err);
              try {
                sdk.SerialPort.close();
              } catch (ignore) {
              }
            }

            return true;
          };

          const executeSetAzIoTHub = async () => {
            try {
              const data = `${command} "${configValue}"\r\n`;

              let restDataLength = data.length;
              while (restDataLength > 0) {
                const start = data.length - restDataLength;
                const length = Math.min(100, restDataLength);
                restDataLength -= length;
                const dataChunk = data.substr(start, length);
                await this.sendDataViaSerialPort(dataChunk);
                await utils.delay(1000);
              }

              sdk.SerialPort.close();
            } catch (ignore) {
            }

            if (errorRejected) {
              return;
            } else {
              resolve(true);
            }
          };

          try {
            await AZ3166Device.registerGetMonitorCallbackCommand();
            // Configure serial port callbacks
            const monitorCallback = await vscode.commands.registerCommand(
              AZ3166Device._monitorCallbackCommandName,
              async (event: string, payload: any, errorMessage: string) => {
                if(event === 'open') {
                  await vscode.window.showInformationMessage(
                    'Please hold down button A and then push and release the reset button to enter configuration mode. After enter configuration mode, click OK.',
                    'OK');
                executeSetAzIoTHub()
                    .then(() => resolve(true))
                    .catch((error) => reject(error));
                } else if (event === 'error') {
                  if (errorRejected) return;
                  console.log(errorMessage);
                  rejectIfError(new Error(errorMessage));
                } else if (event === 'close') {
                  monitorCallback.dispose();
                  AZ3166Device._registerCallback.dispose();                  
                  AZ3166Device._registerCallback = undefined;
                }
              }
            );
          } catch (err) {
            return reject(err);
          }

          try{
            await sdk.SerialPort.open(comPort, {
              baudRate: az3166.defaultBaudRate,
              dataBits: 8,
              stopBits: 1,
              xon: false,
              xoff: false,
              parity: 'none'
            });
          } catch (err) {
            return reject(err);
          }
        }
      );
  }

  async flushDeviceConfig(configValue: string, option: number):
      Promise<boolean> {
    return new Promise(
        async (
            resolve: (value: boolean) => void,
            reject: (value: Error) => void
        ) => {
          let comPort = '';
          let command = '';
          try {
            // Choose COM port that AZ3166 is connected
            const comPortListJson = await sdk.SerialPort.getComList();
            const comList: Array<Object> = JSON.parse(JSON.stringify(comPortListJson))["portList"];
            
            comPort = await this.chooseCOM(comList);
            console.log(`Opening ${comPort}.`);
          } catch (error) {
            reject(error);
          }
          if (option === configDeviceOptions.ConnectionString) {
            command = 'set_az_iothub';
          } else {
            command = 'set_dps_uds';
          }
          let configMode = false;
          let errorRejected = false;
          let commandExecuted = false;
          let gotData = false;

          const az3166 = this.board;

          if (!az3166) {
            return reject(
                new Error('IoT DevKit is not found in the board list.'));
          }

          const rejectIfError = async (err: Error) => {
            if (errorRejected) return true;
            if (err) {
              errorRejected = true;
              reject(err);
              try {
                await sdk.SerialPort.close();
              } catch (ignore) {
              }
            }

            return true;
          };

          const executeSetAzIoTHub = async () => {
            try {
              const data = `${command} "${configValue}"\r\n`;
              await this.sendDataViaSerialPort(data.slice(0, 120));
              if (data.length > 120) {
                await utils.delay(1000);
                await this.sendDataViaSerialPort(data.slice(120));
              }

              await utils.delay(1000);
              await sdk.SerialPort.close();
            } catch (ignore) {
            }

            if (errorRejected) {
              return;
            } else {
              resolve(true);
            }
          };

          try {
            await AZ3166Device.registerGetMonitorCallbackCommand();
            
            // Configure serial port callbacks
            const monitorCallback = await vscode.commands.registerCommand(
              AZ3166Device._monitorCallbackCommandName,
              async (event: string, payload: any, errorMessage: string) => {
                if(event === 'open') {
                  try {
                    // tslint:disable-next-line: no-any
                    await sdk.SerialPort.send('\r\nhelp\r\n');
                  } catch (err) {
                    if (rejectIfError(err)) {
                      return;
                    }
                  }
                } else if (event === 'data') {
                  gotData = true;
                  const output = payload.toString().trim();
                  if (commandExecuted) return;
                  if (output.includes('set_')) {
                    commandExecuted = true;
                    configMode = true;
                    executeSetAzIoTHub()
                        .then(() => resolve(true))
                        .catch((error) => reject(error));
                  } else {
                    configMode = false;
                  }
      
                  if (configMode) {
                    forEach(output.split('\n'), line => {
                      if (line) {
                        line = trimStart(line.trim(), '#').trim();
                        if (line && line.length) {
                          console.log('SerialOutput', line);
                          this.channel.appendLine('SerialOutput  ' +  line);
                        }
                      }
                    });
                  }
                } else if (event === 'error') {
                  if (errorRejected) return;
                  console.log(errorMessage);              
                  rejectIfError(new Error(errorMessage));
                } else if (event === 'close') {
                  monitorCallback.dispose();
                  AZ3166Device._registerCallback.dispose();                    
                  AZ3166Device._registerCallback = undefined;
                }
              }
            );
          } catch (err) {
            return reject(err);
          }

          try {
            await sdk.SerialPort.open(comPort, {
              baudRate: az3166.defaultBaudRate,
              dataBits: 8,
              stopBits: 1,
              xon: false,
              xoff: false,
              parity: 'none'
            });
          } catch (err) {
            console.log(err);
            return reject(err);
          }

          setTimeout(() => {
            if (errorRejected) return;
            // Prompt user to enter configuration mode

            if (!gotData || !configMode) {
              vscode.window
                  .showInformationMessage(
                      'Please hold down button A and then push and release the reset button to enter configuration mode.')
                  .then(async () => {
                    // tslint:disable-next-line: no-any
                    try{
                      await sdk.SerialPort.send('\r\nhelp\r\n');
                    } catch(err) {
                      rejectIfError(err);
                    };
                  });
            }
          }, 10000);
        });
  }

  private async chooseCOM(comList: Array<any>): Promise<string> {
    return new Promise(
        async (
            resolve: (value: string) => void,
            reject: (reason: Error) => void) => {

          const az3166 = this.board;

          if (!az3166) {
            return reject(new Error('AZ3166 is not found in the board list.'));
          }

          const list = _.filter(comList, com => {
            if (com.vendorId && com.productId && az3166.vendorId &&
                az3166.productId &&
                com.vendorId.toLowerCase().endsWith(az3166.vendorId) &&
                com.productId.toLowerCase().endsWith(az3166.productId)) {
              return true;
            } else {
              return false;
            }
          });

          if (list && list.length) {
            let comPort = list[0].comName;
            if (list.length > 1) {
              // TODO: select com port from list when there are multiple AZ3166
              // boards connected
              comPort = list[0].comName;
            }

            if (!comPort) {
              reject(new Error('No avalible COM port.'));
            }

            resolve(comPort);
          } else {
            reject(new Error('No AZ3166 board connected.'));
          }
        });
  }

  // tslint:disable-next-line: no-any
  private async sendDataViaSerialPort(data: string):
    Promise<boolean> {
    return new Promise(
      async (
        resolve: (value: boolean) => void, 
        reject: (value: Error) => void
      ) => {
        try {
          // tslint:disable-next-line: no-any
          await sdk.SerialPort.send(data);
          resolve(true);
        } catch (err) {
          reject(err);
        }
      }
    );
  }

  private async stlinkDriverInstalled() {
    const plat = os.platform();
    if (plat === 'win32') {
      try {
        // The STlink driver would write to the following registry.
        const pathString = await utils.getRegistryValues(
            WinReg.HKLM,
            '\\SYSTEM\\ControlSet001\\Control\\Class\\{88bae032-5a81-49f0-bc3d-a4ff138216d6}',
            'Class');
        if (pathString) {
          return true;
        } else {
          return false;
        }
      } catch (error) {
        return false;
      }
    }
    // For other OS platform, there is no need to install STLink Driver.
    return true;
  }
}
