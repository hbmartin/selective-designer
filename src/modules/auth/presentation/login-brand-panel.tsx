import { useTranslation } from 'react-i18next';

/**
 * Decorative brand panel beside the sign-in form: a product picked from a
 * mood board and placed into an architectural image.
 */
export const LoginBrandPanel = () => {
  const { t } = useTranslation(['auth']);
  return (
    <div className="relative hidden w-full flex-1 flex-col justify-center gap-10 overflow-hidden bg-brand-subtle p-12 text-brand-subtle-foreground lg:flex xl:p-16">
      <PlacementIllustration className="w-full max-w-lg" />
      <div className="flex max-w-md flex-col gap-3">
        <p className="font-display text-4xl font-medium tracking-tight text-balance text-foreground">
          {t('auth:brandPanel.headline')}
        </p>
        <p className="text-base text-balance text-brand-subtle-foreground">
          {t('auth:brandPanel.tagline')}
        </p>
      </div>
    </div>
  );
};

const PlacementIllustration = (props: { className?: string }) => (
  <svg
    viewBox="0 0 480 360"
    fill="none"
    aria-hidden
    className={props.className}
  >
    {/* Architectural image */}
    <rect
      x="8"
      y="8"
      width="360"
      height="270"
      rx="20"
      className="fill-card stroke-current"
      strokeWidth="2"
    />
    <g className="stroke-current" strokeWidth="1.5" opacity="0.55">
      <rect x="98" y="62" width="180" height="128" rx="2" />
      <path d="M28 28 98 62M348 28l-70 34M28 258l70-68M348 258l-70-68" />
      <rect x="122" y="80" width="54" height="72" rx="2" />
      <path d="M149 80v72M122 116h54" />
    </g>
    {/* Placed product, in its selected region */}
    <g className="fill-brand">
      <rect x="196" y="150" width="84" height="26" rx="7" />
      <rect x="202" y="128" width="72" height="30" rx="8" opacity="0.85" />
      <rect x="204" y="175" width="5" height="12" rx="2" />
      <rect x="267" y="175" width="5" height="12" rx="2" />
    </g>
    <rect
      x="182"
      y="114"
      width="112"
      height="84"
      rx="10"
      className="stroke-brand"
      strokeWidth="2"
      strokeDasharray="6 6"
    />
    <g className="fill-card stroke-brand" strokeWidth="2">
      <rect x="177" y="109" width="10" height="10" rx="2" />
      <rect x="289" y="109" width="10" height="10" rx="2" />
      <rect x="177" y="193" width="10" height="10" rx="2" />
      <rect x="289" y="193" width="10" height="10" rx="2" />
    </g>
    {/* Mood board cards */}
    <g transform="rotate(-6 404 266)">
      <rect
        x="344"
        y="206"
        width="120"
        height="120"
        rx="14"
        className="fill-card stroke-current"
        strokeWidth="2"
        opacity="0.7"
      />
    </g>
    <g transform="rotate(5 396 262)">
      <rect
        x="336"
        y="200"
        width="120"
        height="124"
        rx="14"
        className="fill-card stroke-current"
        strokeWidth="2"
      />
      <rect
        x="350"
        y="214"
        width="92"
        height="62"
        rx="8"
        className="fill-brand"
      />
      <rect
        x="350"
        y="288"
        width="64"
        height="8"
        rx="4"
        className="fill-current"
        opacity="0.5"
      />
      <rect
        x="350"
        y="302"
        width="40"
        height="8"
        rx="4"
        className="fill-current"
        opacity="0.3"
      />
    </g>
    {/* Pick → place */}
    <path
      d="M352 214c-20-40-34-58-58-66"
      className="stroke-brand"
      strokeWidth="2"
      strokeLinecap="round"
      strokeDasharray="2 6"
    />
  </svg>
);
