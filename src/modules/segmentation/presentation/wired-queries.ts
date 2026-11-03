import {
  createSegmentationQueries,
  type SegmentationQueryFacade,
} from './queries';
import {
  regionsCreateManual,
  regionsGet,
  regionsRemove,
  regionsSegment,
  regionsUpdate,
} from '../server';

export const segmentationQueries = createSegmentationQueries({
  regionsCreateManual,
  regionsGet,
  regionsRemove,
  regionsSegment,
  regionsUpdate,
} satisfies SegmentationQueryFacade);
