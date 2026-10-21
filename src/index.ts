/**
 * 库入口。
 *
 * 工作流可以脱离 CLI 被嵌进别的系统：
 *
 *   const { runWorkflow, createDrivers, Blackboard } = require('workflow-mvp');
 *   const summary = await runWorkflow(spec, { drivers: createDrivers({...}), workdir });
 */

export { runWorkflow, validateSpec, evaluate, collectRefs } from './core/engine';
export type { EngineOptions, RunSummary } from './core/engine';
export { Blackboard } from './core/blackboard';
export { createConsoleReporter, createFileTracer, fanout } from './core/trace';
export type { TraceSink } from './core/trace';
export { createDrivers } from './registry';
export type { DriverFactoryOptions } from './registry';
export { PlayfulCodeDriver } from './drivers/playfulcode';
export { StaticScanDriver } from './drivers/functions';
export { MockDriver, FlakyDriver } from './drivers/mock';
export { loadPlayfulCode } from './integrations/playfulcode/loader';
export type * from './core/types';
