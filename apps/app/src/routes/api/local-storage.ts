import { localStorageRequest } from "~/lib/document-storage-filesystem";

export const GET = ({ request }: { request: Request }) => localStorageRequest(request);
export const DELETE = GET;
