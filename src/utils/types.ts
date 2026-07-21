import type { MonitorType } from "./constants";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roleId: string;
  roleName: string;
  permissions: string[];
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
      /** Set by the deploy-token middleware for CI/CD maintenance endpoints. */
      deployToken?: { id: string; projectId: string };
    }
  }
}
