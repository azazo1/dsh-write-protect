/**
 * Connection 的 `/api` Fetch 路由注册面 (插件侧用到的最小形状). 走官方鉴权通道,
 * 避免裸 webServer 路由 401 空 body. 预览路由与授权面板路由共用这一份声明.
 * @module dsh-write-protect/connection
 */

/** 注册一条 Fetch 路由所需的最小连接形状. */
export interface FetchRouteConnection {
  fetch: {
    register(route: {
      path: string
      methods: readonly string[]
      fetch: (request: Request) => Promise<Response>
    }): () => void | Promise<void>
  }
}
