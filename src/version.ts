declare const __DSH_DEVECO_VERSION__: string

/** 构建时由 tsdown 注入的包版本；直接跑源码（测试/调试）时退化成 dev 标记。 */
export const DEVECO_VERSION: string = typeof __DSH_DEVECO_VERSION__ === 'string'
  ? __DSH_DEVECO_VERSION__
  : '0.0.0-dev'
