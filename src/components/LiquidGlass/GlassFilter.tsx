import type { LensDisplacementMap } from './lensDisplacementMap'

/**
 * SVG 滤镜：透镜位移折射 + 边缘色散
 *
 * 透镜贴图中心是中性灰（零位移），中心天然保持清晰；RGB 三通道位移量递减，
 * 在折射最强的边缘自然分离出色散。
 * 几何约定（Chromium 实测）：feImage 的像素几何 (0,0,w,h) 与元素原点精确对齐，
 * 负坐标/百分比几何解析不可靠；滤镜区域收紧为元素本身，位移不会画出卡片之外。
 * scale 用 2×maxScale 还原贴图编码的几何位移，displacementScale 以 70 为基准整体缩放
 */
export default function GlassFilter({ id, map, displacementScale, aberrationIntensity }: {
    id: string
    map: LensDisplacementMap
    displacementScale: number
    aberrationIntensity: number
}) {
    const scale = 2 * map.maxScale * (displacementScale / 70)
    return (
        <svg style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }} aria-hidden="true">
            <defs>
                <filter id={id} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
                    <feImage x="0" y="0" width={map.width} height={map.height} result="DISPLACEMENT_MAP" href={map.url} preserveAspectRatio="none" />

                    <feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" scale={scale} xChannelSelector="R" yChannelSelector="B" result="RED_DISPLACED" />
                    <feColorMatrix
                        in="RED_DISPLACED"
                        type="matrix"
                        values="1 0 0 0 0
                 0 0 0 0 0
                 0 0 0 0 0
                 0 0 0 1 0"
                        result="RED_CHANNEL"
                    />

                    <feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" scale={scale * (1 - aberrationIntensity * 0.05)} xChannelSelector="R" yChannelSelector="B" result="GREEN_DISPLACED" />
                    <feColorMatrix
                        in="GREEN_DISPLACED"
                        type="matrix"
                        values="0 0 0 0 0
                 0 1 0 0 0
                 0 0 0 0 0
                 0 0 0 1 0"
                        result="GREEN_CHANNEL"
                    />

                    <feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" scale={scale * (1 - aberrationIntensity * 0.1)} xChannelSelector="R" yChannelSelector="B" result="BLUE_DISPLACED" />
                    <feColorMatrix
                        in="BLUE_DISPLACED"
                        type="matrix"
                        values="0 0 0 0 0
                 0 0 0 0 0
                 0 0 1 0 0
                 0 0 0 1 0"
                        result="BLUE_CHANNEL"
                    />

                    {/* screen 混合合并三通道：位移一致的区域无损还原原色 */}
                    <feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED" />
                    <feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="RGB_COMBINED" />

                    <feGaussianBlur in="RGB_COMBINED" stdDeviation={Math.max(0.1, 0.5 - aberrationIntensity * 0.1)} />
                </filter>
            </defs>
        </svg>
    )
}
