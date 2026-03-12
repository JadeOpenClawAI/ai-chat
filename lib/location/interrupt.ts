import type { StreamAnnotation } from '@/lib/types';

export class LocationRequestInterruptError extends Error {
  annotation?: StreamAnnotation;

  constructor(message: string, annotation?: StreamAnnotation) {
    super(message);
    this.name = 'LocationRequestInterruptError';
    this.annotation = annotation;
  }
}

export function isLocationRequestInterruptError(error: unknown): error is LocationRequestInterruptError {
  return error instanceof LocationRequestInterruptError
    || (
      typeof error === 'object'
      && error !== null
      && 'name' in error
      && (error as { name?: unknown }).name === 'LocationRequestInterruptError'
    );
}
