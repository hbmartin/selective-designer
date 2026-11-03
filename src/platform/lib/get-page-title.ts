export const getPageTitle = (pageTitle?: string, titlePrefix = '') => {
  const prefix = titlePrefix ? `${titlePrefix} ` : '';
  return pageTitle
    ? `${prefix}${pageTitle} | Selective Designer`
    : `${prefix}Selective Designer`;
};
