export function npmPackFilename(result) {
  const packages = Array.isArray(result)
    ? result
    : result !== null && typeof result === "object"
      ? Object.values(result)
      : null;

  if (!packages || packages.length !== 1) {
    throw new Error("npm pack did not produce exactly one package");
  }

  const filename = packages[0]?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("npm pack did not report its tarball filename");
  }
  return filename;
}
