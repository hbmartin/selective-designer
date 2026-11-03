import { createDesignQueries, type DesignQueryFacade } from './queries';
import {
  designAddSourcePhoto,
  designArchive,
  designCreate,
  designGetAll,
  designGetById,
  designListSourcePhotos,
  designRename,
  designUnarchive,
} from '../server';

export const designQueries = createDesignQueries({
  designAddSourcePhoto,
  designArchive,
  designCreate,
  designGetAll,
  designGetById,
  designListSourcePhotos,
  designRename,
  designUnarchive,
} satisfies DesignQueryFacade);
