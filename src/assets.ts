import { AssetType, defineAssets } from '@iwsdk/core';
import { createGondolaHull, createGondolaRigging } from './scene-assets/gondola.scene-asset.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  'gondola-hull': createGondolaHull(),
  'gondola-rigging': createGondolaRigging(),
  'welcome-panel': {
    url: publicAssetUrl('ui/welcome.uikitml'),
    type: AssetType.UIKitML,
    name: 'Welcome Panel',
  },
});
