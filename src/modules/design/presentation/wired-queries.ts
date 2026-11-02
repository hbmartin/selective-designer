import { createDesignQueries, type DesignQueryFacade } from './queries';
import {
  designArchive,
  designCreate,
  designGetAll,
  designGetById,
  designRename,
  designUnarchive,
} from '../server';

export const designQueries = createDesignQueries({
  designArchive,
  designCreate,
  designGetAll,
  designGetById,
  designRename,
  designUnarchive,
} satisfies DesignQueryFacade);
