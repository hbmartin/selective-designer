import account from './account.json' with { type: 'json' };
import auth from './auth.json' with { type: 'json' };
import buildInfo from './build-info.json' with { type: 'json' };
import common from './common.json' with { type: 'json' };
import components from './components.json' with { type: 'json' };
import design from './design.json' with { type: 'json' };
import layout from './layout.json' with { type: 'json' };
import moodboard from './moodboard.json' with { type: 'json' };
import rendering from './rendering.json' with { type: 'json' };
import segmentation from './segmentation.json' with { type: 'json' };
import user from './user.json' with { type: 'json' };

export default {
  account,
  auth,
  buildInfo,
  common,
  components,
  design,
  layout,
  moodboard,
  rendering,
  segmentation,
  user,
} as const;
