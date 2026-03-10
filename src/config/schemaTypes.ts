export type ConfigSectionKey = 'policy' | 'risk';

interface ConfigFieldBase {
  key: string;
  label: string;
  description?: string;
}

export interface NumberField extends ConfigFieldBase {
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  integer?: boolean;
}

export interface BooleanField extends ConfigFieldBase {
  type: 'boolean';
}

export interface EnumField extends ConfigFieldBase {
  type: 'enum';
  options: string[];
}

export type ConfigField = NumberField | BooleanField | EnumField;

export interface ConfigSection {
  key: ConfigSectionKey;
  label: string;
  description?: string;
  fields: ConfigField[];
}

export interface ConfigSchema {
  version: string;
  sections: ConfigSection[];
}
