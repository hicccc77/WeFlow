import type { ComponentType, SVGProps } from 'react'

/**
 * 通用图标组件类型：与具体图标库解耦。
 * 基于 SVGProps<SVGSVGElement>——lucide / @gravity-ui/icons 的图标组件都接受
 * className / strokeWidth / style / width / height 等标准 SVG 属性。
 */
export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

