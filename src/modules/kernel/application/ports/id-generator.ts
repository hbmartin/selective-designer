import type { GeneratedId, ParseResult } from '../../domain/ids';

export interface IdGenerator {
  createId(): ParseResult<GeneratedId>;
}
