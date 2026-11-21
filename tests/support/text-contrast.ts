/** Measure solid text against its rendered, composited ancestor backgrounds. */
export function measureTextContrast(element: Element) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('A 2D canvas is required to measure contrast');
  function assignColor(value: string) {
    context!.fillStyle = '#010203';
    context!.fillStyle = value;
    const first = context!.fillStyle;
    context!.fillStyle = '#040506';
    context!.fillStyle = value;
    if (context!.fillStyle !== first)
      throw new Error('Unsupported canvas color');
  }

  const ancestors: Element[] = [];
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  )
    ancestors.unshift(current);

  for (const ancestor of ancestors) {
    const style = getComputedStyle(ancestor);
    if (
      style.backgroundImage !== 'none' ||
      Number(style.opacity) !== 1 ||
      style.filter !== 'none' ||
      style.backdropFilter !== 'none' ||
      style.mixBlendMode !== 'normal' ||
      style.backgroundBlendMode !== 'normal'
    )
      throw new Error(
        'Contrast measurement requires solid backgrounds without opacity, filters, or blending'
      );
    assignColor(style.backgroundColor);
    context.fillRect(0, 0, 1, 1);
  }
  const background = [...context.getImageData(0, 0, 1, 1).data];
  if (background[3] !== 255)
    throw new Error(
      'Contrast measurement requires an opaque ancestor background'
    );

  assignColor(getComputedStyle(element).color);
  context.fillRect(0, 0, 1, 1);
  const foreground = [...context.getImageData(0, 0, 1, 1).data];

  function luminance(channels: number[]) {
    const linear = channels.slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  }
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return {
    foreground: foreground.slice(0, 3),
    background: background.slice(0, 3),
    ratio:
      (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
  };
}
