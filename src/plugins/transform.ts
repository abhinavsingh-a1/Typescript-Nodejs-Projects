// Plugin: reshape data. "pick" keeps only some fields, "set" adds fields.
import type { Data, NodePlugin } from '../types.js';
import { asObject } from './helpers.js';

interface TransformParams {
  pick?: string[];
  set?: Data;
}

export const transformPlugin: NodePlugin<TransformParams> = {
  type: 'transform',
  description: 'Keep some fields ("pick") and/or add fields ("set").',
  validate(params) {
    const { pick, set } = asObject(params);
    if (pick !== undefined && (!Array.isArray(pick) || !pick.every((k) => typeof k === 'string'))) {
      throw new Error('params.pick must be a list of field names');
    }
    return { pick: pick as string[] | undefined, set: set === undefined ? undefined : asObject(set, 'params.set') };
  },
  async execute(input, { pick, set }) {
    const base = pick ? Object.fromEntries(pick.filter((k) => k in input).map((k) => [k, input[k]])) : { ...input };
    return { ...base, ...(set ?? {}) };
  },
};
