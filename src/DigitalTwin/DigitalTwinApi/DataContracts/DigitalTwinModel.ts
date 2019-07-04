// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

export interface DigitalTwinModelBase {
  contents?: string;
  comment?: string;
  description?: string;
  displayName?: LocalizedData[];
  urnId: string;
  modelName: string;
  version: number;
  type: string;
  etag: string;
  publisherId: string;
  publisherName: string;
  createdOn: string;
  lastUpdated: string;
}

export interface DigitalTwinModel extends DigitalTwinModelBase {
  contents: string;
}

export interface LocalizedData {
  locale: string;
  value: string;
}