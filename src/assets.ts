import { AssetType, defineAssets } from '@iwsdk/core';
import { createGondolaHull, createGondolaRigging } from './scene-assets/gondola.scene-asset.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  'gondola-hull': createGondolaHull(),
  'gondola-rigging': createGondolaRigging(),
  'start-panel': {
    url: publicAssetUrl('ui/start.uikitml'),
    type: AssetType.UIKitML,
    name: 'Start Screen',
  },
  'menu-panel': {
    url: publicAssetUrl('ui/menu.uikitml'),
    type: AssetType.UIKitML,
    name: 'Game Menu',
  },
});
