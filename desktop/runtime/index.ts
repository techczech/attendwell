// Public surface of the AttendWell desktop runtime. The Electron main process imports only from here.
export {createRuntime,type Runtime,type RuntimeOptions,type RuntimeSettings,type RuntimeSnapshot,type RuntimeStatus,type OriginChange,type StopReport,type RegisterLeaseInfo} from './runtime.ts';
export type {WorkshopsLibrary,WorkshopRecord,WorkshopSummary,WorkshopListing,NewWorkshop,RosterProvenance} from './workshops-library.ts';
export type {ServiceState,ServiceFailure} from './service-supervisor.ts';
export type {TunnelSettings,TunnelState} from './tunnel-supervisor.ts';
export {GATEWAY_BODY_LIMIT} from './participant-gateway.ts';
export {FAILURE_TEXT as TUNNEL_FAILURE_TEXT,type TunnelFailure} from './cloudflared-output.ts';
export {platformKey,resourcePaths,type PlatformKey} from './platform.ts';
