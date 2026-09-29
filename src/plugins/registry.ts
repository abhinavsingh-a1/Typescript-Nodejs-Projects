// Plugin registry. To add a node type: write one file, add one line below.
import type { NodePlugin } from '../types.js';
import { delayPlugin } from './delay.js';
import { httpPlugin } from './http.js';
import { tbRiskMockPlugin } from './tbRiskMock.js';
import { transformPlugin } from './transform.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPlugin = NodePlugin<any>; // each plugin has its own params type

const plugins = new Map<string, AnyPlugin>();

export function registerPlugin(plugin: AnyPlugin): void {
  if (plugins.has(plugin.type)) throw new Error(`Plugin "${plugin.type}" registered twice`);
  plugins.set(plugin.type, plugin);
}

export function getPlugin(type: string): AnyPlugin | undefined {
  return plugins.get(type);
}

export function listPlugins(): { type: string; description: string }[] {
  return [...plugins.values()].map((p) => ({ type: p.type, description: p.description }));
}

// ---- Built-in plugins ----
registerPlugin(transformPlugin);
registerPlugin(delayPlugin);
registerPlugin(httpPlugin);
registerPlugin(tbRiskMockPlugin);
