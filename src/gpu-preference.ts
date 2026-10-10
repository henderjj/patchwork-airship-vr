/**
 * Ask for the high-performance GPU for the game's WebGL context.
 *
 * On a PC with two graphics adapters (most laptops, and desktops with the
 * CPU's graphics enabled) a browser puts WebGL on the low-power one by
 * default, while Link renders on the graphics card the headset uses. Entering
 * VR then has to move the context across (`makeXRCompatible`), which loses
 * and restores it, and the session dies with it (John's Chrome over Air Link,
 * 2026-10-10). three.js passes `powerPreference: 'default'` unless told
 * otherwise, and IWSDK creates the renderer without saying, so this changes
 * the default for WebGL contexts made after it runs. Call it before
 * `World.create`. It changes nothing on a single-GPU device such as a Quest.
 */
export function preferHighPerformanceGpu(): void {
  const proto = HTMLCanvasElement.prototype;
  const getContext = proto.getContext as (this: HTMLCanvasElement, id: string, options?: unknown) => RenderingContext | null;
  proto.getContext = function (this: HTMLCanvasElement, id: string, options?: unknown) {
    if (id === 'webgl2' || id === 'webgl') {
      const attributes = (options ?? {}) as WebGLContextAttributes;
      if (attributes.powerPreference === undefined || attributes.powerPreference === 'default') {
        return getContext.call(this, id, { ...attributes, powerPreference: 'high-performance' });
      }
    }
    return getContext.call(this, id, options);
  } as typeof proto.getContext;
}
