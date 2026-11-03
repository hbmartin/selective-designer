import { createMoodboardQueries, type MoodboardQueryFacade } from './queries';
import {
  moodboardCategories,
  moodboardCutoutCorrect,
  moodboardCutoutRetry,
  moodboardGet,
  moodboardItemCreate,
  moodboardItemRemove,
  moodboardItemUpdate,
} from '../server';

export const moodboardQueries = createMoodboardQueries({
  moodboardCategories,
  moodboardCutoutCorrect,
  moodboardCutoutRetry,
  moodboardGet,
  moodboardItemCreate,
  moodboardItemRemove,
  moodboardItemUpdate,
} satisfies MoodboardQueryFacade);
