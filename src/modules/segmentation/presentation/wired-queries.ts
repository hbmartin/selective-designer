import {
  createSegmentationQueries,
  type SegmentationQueryFacade,
} from './queries';
import {
  regionsCreateManual,
  regionsGet,
  regionsRemove,
  regionsRetryDetection,
  regionsSegment,
  regionsUpdate,
} from '../server';

export const segmentationQueries = createSegmentationQueries({
  regionsCreateManual,
  regionsGet,
  regionsRemove,
  regionsRetryDetection,
  regionsSegment,
  regionsUpdate,
} satisfies SegmentationQueryFacade);
