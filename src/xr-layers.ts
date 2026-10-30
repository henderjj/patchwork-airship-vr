/**
 * Keep three.js on an XRWebGLLayer for a session that wasn't granted WebXR
 * Layers.
 *
 * three.js (IWSDK's super-three r181) picks a projection layer whenever the
 * browser has `XRWebGLBinding.prototype.createProjectionLayer`, without
 * checking that the session was granted the `layers` feature. Chrome on
 * Windows has had that method since it turned Layers on for every platform
 * (2026), and a Rift on Chrome 156 then got no XR frames at all: the session
 * was visible for nine seconds and the runtime closed it (2026-10-30, even
 * with `layers` left out of the request). Hiding the method from the binding's
 * prototype for the length of such a session makes three.js take the
 * XRWebGLLayer path the PC was tested with (spike S8). A session that was
 * granted Layers (the Quest Browser) is left alone.
 *
 * Returns a function that puts the method back, or null when nothing was hidden.
 */
export function hideProjectionLayers(proto: object | undefined, features: readonly string[] | undefined): (() => void) | null {
  if (proto == null || features == null || features.includes('layers')) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'createProjectionLayer');
  if (descriptor == null || !descriptor.configurable) {
    return null;
  }
  delete (proto as { createProjectionLayer?: unknown }).createProjectionLayer;
  return () => {
    Object.defineProperty(proto, 'createProjectionLayer', descriptor);
  };
}

/** The name of what a session draws through, for the console: "XRWebGLLayer", "XRProjectionLayer" or "nothing yet". */
export function describeDrawing(renderState: { baseLayer?: unknown; layers?: readonly unknown[] }): string {
  const name = (layer: unknown) => (layer as { constructor?: { name?: string } } | null)?.constructor?.name || 'a layer';
  if (renderState.layers != null && renderState.layers.length > 0) {
    return renderState.layers.map(name).join(' + ');
  }
  return renderState.baseLayer != null ? name(renderState.baseLayer) : 'nothing yet';
}
