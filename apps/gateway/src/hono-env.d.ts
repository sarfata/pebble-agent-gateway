import type { AuthUser } from "./services/auth.js";

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
  }
}
