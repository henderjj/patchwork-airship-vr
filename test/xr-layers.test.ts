import { describe, expect, it } from 'vitest';
import { describeDrawing, hideProjectionLayers } from '../src/xr-layers.js';

class FakeBinding {
  createProjectionLayer(): string {
    return 'projection';
  }
}

describe('hideProjectionLayers', () => {
  it('hides createProjectionLayer for a session without Layers, and puts it back', () => {
    const restore = hideProjectionLayers(FakeBinding.prototype, ['local', 'viewer', 'local-floor']);
    expect(restore).not.toBeNull();
    expect('createProjectionLayer' in FakeBinding.prototype).toBe(false);
    restore?.();
    expect(new FakeBinding().createProjectionLayer()).toBe('projection');
  });

  it('leaves it for a session granted Layers, or one that does not report its features', () => {
    expect(hideProjectionLayers(FakeBinding.prototype, ['local-floor', 'layers'])).toBeNull();
    expect(hideProjectionLayers(FakeBinding.prototype, undefined)).toBeNull();
    expect(hideProjectionLayers(undefined, ['local'])).toBeNull();
    expect('createProjectionLayer' in FakeBinding.prototype).toBe(true);
  });
});

describe('describeDrawing', () => {
  class XRWebGLLayer {}
  class XRProjectionLayer {}

  it('names the layer the session draws through', () => {
    expect(describeDrawing({ baseLayer: new XRWebGLLayer(), layers: [] })).toBe('XRWebGLLayer');
    expect(describeDrawing({ layers: [new XRProjectionLayer()] })).toBe('XRProjectionLayer');
    expect(describeDrawing({})).toBe('nothing yet');
  });
});
