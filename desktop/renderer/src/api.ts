import type { AttendWellApi } from '../../shared/ipc.ts';

declare global {
  interface Window { attendwell: AttendWellApi }
}

export const api: AttendWellApi = window.attendwell;
