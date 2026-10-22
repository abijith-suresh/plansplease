/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as authConfig from "../authConfig.js";
import type * as cliCredentials from "../cliCredentials.js";
import type * as crons from "../crons.js";
import type * as documentDeletion from "../documentDeletion.js";
import type * as documentDeletionStorage from "../documentDeletionStorage.js";
import type * as documentProof from "../documentProof.js";
import type * as documents from "../documents.js";
import type * as http from "../http.js";
import type * as localMode from "../localMode.js";
import type * as mcpDocuments from "../mcpDocuments.js";
import type * as mcpProof from "../mcpProof.js";
import type * as pluginEndpoints from "../pluginEndpoints.js";
import type * as storageQuota from "../storageQuota.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  authConfig: typeof authConfig;
  cliCredentials: typeof cliCredentials;
  crons: typeof crons;
  documentDeletion: typeof documentDeletion;
  documentDeletionStorage: typeof documentDeletionStorage;
  documentProof: typeof documentProof;
  documents: typeof documents;
  http: typeof http;
  localMode: typeof localMode;
  mcpDocuments: typeof mcpDocuments;
  mcpProof: typeof mcpProof;
  pluginEndpoints: typeof pluginEndpoints;
  storageQuota: typeof storageQuota;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
};
