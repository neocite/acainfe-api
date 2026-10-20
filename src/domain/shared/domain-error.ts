export type DomainErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'UNAUTHORIZED'
  | 'CERTIFICATE_INVALID'
  | 'CERTIFICATE_MISSING'
  /** Serviço externo fora do ar (ex.: consulta de CNPJ): o usuário pode tentar de novo. */
  | 'UNAVAILABLE';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DomainError';
  }

  static validation(message: string, details?: Record<string, unknown>): DomainError {
    return new DomainError('VALIDATION', message, details);
  }

  static notFound(entity: string, id: string): DomainError {
    return new DomainError('NOT_FOUND', `${entity} não encontrado: ${id}`, { entity, id });
  }

  static invalidState(message: string, details?: Record<string, unknown>): DomainError {
    return new DomainError('INVALID_STATE', message, details);
  }
}
