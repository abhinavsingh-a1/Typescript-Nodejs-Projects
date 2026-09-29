// Plugin: DEMO "TB risk model".
// A simple formula that stands in for a real ML model call.
// NOT a medical model. In real life this node would call the model server.
import type { NodePlugin } from '../types.js';
import { asObject, isNumberBetween } from './helpers.js';

export const tbRiskMockPlugin: NodePlugin<{ threshold: number }> = {
  type: 'tbRiskMock',
  description: 'Demo TB risk score from input.opacityScore (0-1) and input.coughWeeks. Not a medical model.',
  validate(params) {
    const { threshold = 60 } = asObject(params);
    if (!isNumberBetween(threshold, 1, 100)) throw new Error('params.threshold must be 1-100');
    return { threshold };
  },
  async execute(input, { threshold }) {
    const { opacityScore, coughWeeks } = input;
    if (!isNumberBetween(opacityScore, 0, 1)) throw new Error('input.opacityScore must be a number from 0 to 1');
    if (!isNumberBetween(coughWeeks, 0, 520)) throw new Error('input.coughWeeks must be a number from 0 to 520');

    const percent = Math.round(100 * (0.7 * opacityScore + 0.3 * Math.min(coughWeeks / 4, 1)));
    const level = percent >= threshold ? 'high' : percent >= threshold / 2 ? 'medium' : 'low';
    return {
      ...input,
      tbRisk: { percent, level, model: 'tb-risk-mock-v1', note: 'Demo formula, not a medical model.' },
    };
  },
};
