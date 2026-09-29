// Plugin: wait a little (e.g. give another system time).
import type { NodePlugin } from '../types.js';
import { asObject, isNumberBetween } from './helpers.js';

export const delayPlugin: NodePlugin<{ ms: number }> = {
  type: 'delay',
  description: 'Wait a number of milliseconds (0-5000). Passes input through.',
  validate(params) {
    const { ms } = asObject(params);
    if (!isNumberBetween(ms, 0, 5000)) throw new Error('params.ms must be a number from 0 to 5000');
    return { ms };
  },
  async execute(input, { ms }) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return input;
  },
};
