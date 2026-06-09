import type { MonitorType, Role } from "./constants";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** Internal job descriptor passed to a check run (manual or scheduled). */
export interface CheckJob {
  monitorId: string;
  type: MonitorType;
  manual?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      id?: string;
    }
  }
}
