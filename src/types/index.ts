export type FieldRule = {
  required?: boolean;
  type?: 'string' | 'number' | 'boolean';
  maxLength?: number;
  minLength?: number;
};

export type Schema = Record<string, FieldRule>;
