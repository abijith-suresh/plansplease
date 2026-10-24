export class ConvexConfigurationError extends Error {
  constructor() {
    super("Convex is not configured");
    this.name = "ConvexConfigurationError";
  }
}

export const isConvexConfigurationError = (error: unknown): error is ConvexConfigurationError =>
  error instanceof ConvexConfigurationError;
