/** Error con código HTTP que el manejador global convierte en respuesta JSON. */
export class HttpError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const unauthorized = (msg = "No autenticado") => new HttpError(401, msg);
export const forbidden = (msg = "No tienes permiso para esta acción") => new HttpError(403, msg);
export const notFound = (msg = "No encontrado") => new HttpError(404, msg);
