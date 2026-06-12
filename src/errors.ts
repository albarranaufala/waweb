/** An error carrying an HTTP status code; thrown anywhere and rendered by the error middleware. */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (m: string) => new ApiError(400, m);
export const notFound = (m: string) => new ApiError(404, m);
export const conflict = (m: string) => new ApiError(409, m);
export const unprocessable = (m: string) => new ApiError(422, m);
