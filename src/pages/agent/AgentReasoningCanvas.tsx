import { useEffect, useRef, useState } from 'react'

const GRID_COLUMNS = 72
const GRID_ROWS = 6
const SOURCE_COLUMNS = 6
const FLOW_SPEED = 28

const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 v_uv;

void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`

const SIMULATION_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 out_color;

uniform sampler2D u_previous;
uniform vec2 u_grid;
uniform float u_time;
uniform float u_delta;
uniform float u_speed;
uniform float u_source_columns;

float hash21(vec2 value) {
  vec3 p = fract(vec3(value.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

vec3 sourceColor(vec2 cell, float epoch) {
  float brightnessNoise = hash21(cell + vec2(epoch * 1.91, epoch * 0.83));
  float shade = hash21(cell.yx + vec2(epoch * 2.47, epoch * 3.13));
  float brightness = 0.18 + pow(brightnessNoise, 0.72) * 1.08;
  vec3 ember = vec3(0.25, 0.055, 0.58);
  vec3 violet = vec3(0.68, 0.31, 1.0);
  vec3 whiteHot = vec3(1.0, 0.91, 1.0);
  vec3 hue = mix(ember, violet, smoothstep(0.05, 0.76, shade));
  hue = mix(hue, whiteHot, pow(shade, 3.2));
  return hue * brightness;
}

void main() {
  vec2 texel = 1.0 / u_grid;
  float travel = u_delta * u_speed * texel.x;
  vec2 previousUv = vec2(min(v_uv.x + travel, 1.0 - texel.x * 0.5), v_uv.y);
  vec3 carried = texture(u_previous, previousUv).rgb;

  carried *= exp(-u_delta * 0.48);
  carried *= mix(0.985, 1.0, smoothstep(0.0, 0.30, v_uv.x));

  float cadence = 13.0;
  float frame = floor(u_time * cadence);
  float frameMix = smoothstep(0.0, 1.0, fract(u_time * cadence));
  vec2 cell = floor(v_uv * u_grid);
  vec3 nextSource = mix(sourceColor(cell, frame), sourceColor(cell, frame + 1.0), frameMix);
  float sourceStart = 1.0 - u_source_columns / u_grid.x;
  float isSource = step(sourceStart, v_uv.x);
  float sourceDepth = clamp((v_uv.x - sourceStart) / max(1.0 - sourceStart, 0.0001), 0.0, 1.0);
  vec3 sourceFloor = mix(vec3(0.42, 0.15, 0.78), vec3(1.0, 0.94, 1.0), sourceDepth);
  nextSource = max(nextSource, sourceFloor * mix(0.34, 0.92, sourceDepth));

  out_color = vec4(mix(carried, nextSource, isSource), 1.0);
}`

const DISPLAY_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 out_color;

uniform sampler2D u_state;
uniform vec2 u_grid;
uniform vec2 u_canvas_size;
uniform float u_time;

float hashCell(vec2 value) {
  return fract(sin(dot(value, vec2(12.9898, 78.233))) * 43758.5453);
}

float luminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec2 gridPosition = v_uv * u_grid;
  vec2 cellId = floor(gridPosition);
  vec2 cellUv = (cellId + 0.5) / u_grid;
  vec3 energy = texture(u_state, cellUv).rgb;

  vec2 cellPixels = u_canvas_size / u_grid;
  vec2 localPixels = (fract(gridPosition) - 0.5) * cellPixels;
  float squareSize = min(cellPixels.x, cellPixels.y) * 0.78;
  float radius = max(0.55, squareSize * 0.15);
  vec2 box = abs(localPixels) - vec2(max(squareSize * 0.5 - radius, 0.0));
  float distanceToBox = length(max(box, 0.0)) + min(max(box.x, box.y), 0.0) - radius;
  float square = 1.0 - smoothstep(-0.35, 0.65, distanceToBox);
  float glow = 1.0 - smoothstep(0.0, max(2.5, squareSize * 1.35), distanceToBox);

  float fade = smoothstep(0.02, 0.52, v_uv.x);
  float heat = smoothstep(0.45, 0.96, v_uv.x);
  float power = 1.0 - exp(-max(luminance(energy), 0.0) * fade * 1.2);
  power = max(power, heat * (0.06 + hashCell(cellId + vec2(17.0, 41.0)) * 0.10));
  float seed = hashCell(cellId + vec2(3.0, 19.0));
  float seedB = hashCell(cellId.yx + vec2(47.0, 11.0));
  float flowPulse = sin(cellId.x * 0.72 + u_time * 8.5 + seed * 6.28318) * 0.5 + 0.5;
  float slowPulse = sin(u_time * (2.2 + seedB * 2.4) + seedB * 12.0) * 0.5 + 0.5;
  float flicker = smoothstep(0.08, 0.92, flowPulse * 0.68 + slowPulse * 0.32);
  power *= mix(0.42, 1.28, flicker);
  float spark = step(0.86, seedB) * pow(max(sin(u_time * (4.0 + seed * 3.0) + seed * 31.0), 0.0), 12.0);
  power = min(power + spark * fade * 0.48, 1.0);
  vec3 hue = power > 0.0001 ? energy / max(luminance(energy), 0.0001) : vec3(0.0);
  hue = mix(hue, vec3(1.0, 0.91, 1.0), heat * 0.78);
  float alpha = clamp(power * (square + glow * 0.24), 0.0, 1.0);
  vec3 color = hue * alpha * (1.0 + square * 0.2);

  out_color = vec4(color, alpha);
}`

type RenderTarget = {
  framebuffer: WebGLFramebuffer
  texture: WebGLTexture
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Unable to create WebGL shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Unknown shader compilation error'
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

function createProgram(gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()
  if (!program) throw new Error('Unable to create WebGL program')
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'Unknown WebGL link error'
    gl.deleteProgram(program)
    throw new Error(message)
  }
  return program
}

function createInitialState(): Uint8Array {
  return new Uint8Array(GRID_COLUMNS * GRID_ROWS * 4)
}

function createRenderTarget(gl: WebGL2RenderingContext, initialState: Uint8Array): RenderTarget {
  const texture = gl.createTexture()
  const framebuffer = gl.createFramebuffer()
  if (!texture || !framebuffer) throw new Error('Unable to create WebGL render target')

  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    GRID_COLUMNS,
    GRID_ROWS,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    initialState,
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer)
    gl.deleteTexture(texture)
    throw new Error('WebGL framebuffer is incomplete')
  }

  return { framebuffer, texture }
}

type AgentReasoningCanvasProps = {
  isExiting?: boolean
}

export function AgentReasoningCanvas({ isExiting = false }: AgentReasoningCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [contextVersion, setContextVersion] = useState(0)
  const [isUnavailable, setIsUnavailable] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: true,
    })
    if (!gl) {
      setIsUnavailable(true)
      return
    }

    setIsUnavailable(false)
    let animationFrame = 0
    let stopped = false
    let previousTime = performance.now()
    let simulationProgram: WebGLProgram | null = null
    let displayProgram: WebGLProgram | null = null
    let vertexArray: WebGLVertexArrayObject | null = null
    let readTarget: RenderTarget | null = null
    let writeTarget: RenderTarget | null = null

    const handleContextLost = (event: Event) => {
      event.preventDefault()
      stopped = true
      window.cancelAnimationFrame(animationFrame)
    }
    const handleContextRestored = () => setContextVersion((version) => version + 1)
    canvas.addEventListener('webglcontextlost', handleContextLost)
    canvas.addEventListener('webglcontextrestored', handleContextRestored)

    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect()
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      const width = Math.max(1, Math.round(rect.width * pixelRatio))
      const height = Math.max(1, Math.round(rect.height * pixelRatio))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
    }
    const resizeObserver = new ResizeObserver(resizeCanvas)
    resizeObserver.observe(canvas)
    resizeCanvas()

    try {
      simulationProgram = createProgram(gl, SIMULATION_SHADER)
      displayProgram = createProgram(gl, DISPLAY_SHADER)
      vertexArray = gl.createVertexArray()
      if (!vertexArray) throw new Error('Unable to create WebGL vertex array')
      gl.bindVertexArray(vertexArray)

      const initialState = createInitialState()
      readTarget = createRenderTarget(gl, initialState)
      writeTarget = createRenderTarget(gl, initialState)

      const simulationUniforms = {
        previous: gl.getUniformLocation(simulationProgram, 'u_previous'),
        grid: gl.getUniformLocation(simulationProgram, 'u_grid'),
        time: gl.getUniformLocation(simulationProgram, 'u_time'),
        delta: gl.getUniformLocation(simulationProgram, 'u_delta'),
        speed: gl.getUniformLocation(simulationProgram, 'u_speed'),
        sourceColumns: gl.getUniformLocation(simulationProgram, 'u_source_columns'),
      }
      const displayUniforms = {
        state: gl.getUniformLocation(displayProgram, 'u_state'),
        grid: gl.getUniformLocation(displayProgram, 'u_grid'),
        canvasSize: gl.getUniformLocation(displayProgram, 'u_canvas_size'),
        time: gl.getUniformLocation(displayProgram, 'u_time'),
      }

      const renderDisplay = (texture: WebGLTexture, time: number) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.useProgram(displayProgram)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.uniform1i(displayUniforms.state, 0)
        gl.uniform2f(displayUniforms.grid, GRID_COLUMNS, GRID_ROWS)
        gl.uniform2f(displayUniforms.canvasSize, canvas.width, canvas.height)
        gl.uniform1f(displayUniforms.time, time / 1000)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }

      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      const render = (time: number) => {
        if (stopped || !readTarget || !writeTarget) return
        const delta = Math.min(Math.max((time - previousTime) / 1000, 0.001), 0.05)
        previousTime = time

        gl.bindFramebuffer(gl.FRAMEBUFFER, writeTarget.framebuffer)
        gl.viewport(0, 0, GRID_COLUMNS, GRID_ROWS)
        gl.useProgram(simulationProgram)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, readTarget.texture)
        gl.uniform1i(simulationUniforms.previous, 0)
        gl.uniform2f(simulationUniforms.grid, GRID_COLUMNS, GRID_ROWS)
        gl.uniform1f(simulationUniforms.time, time / 1000)
        gl.uniform1f(simulationUniforms.delta, delta)
        gl.uniform1f(simulationUniforms.speed, FLOW_SPEED)
        gl.uniform1f(simulationUniforms.sourceColumns, SOURCE_COLUMNS)
        gl.drawArrays(gl.TRIANGLES, 0, 3)

        renderDisplay(writeTarget.texture, time)
        const swap = readTarget
        readTarget = writeTarget
        writeTarget = swap

        if (!reduceMotion) animationFrame = window.requestAnimationFrame(render)
      }

      animationFrame = window.requestAnimationFrame(render)
    } catch (error) {
      console.error('Failed to initialize reasoning canvas:', error)
      setIsUnavailable(true)
    }

    return () => {
      stopped = true
      window.cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      canvas.removeEventListener('webglcontextrestored', handleContextRestored)
      if (readTarget) {
        gl.deleteFramebuffer(readTarget.framebuffer)
        gl.deleteTexture(readTarget.texture)
      }
      if (writeTarget) {
        gl.deleteFramebuffer(writeTarget.framebuffer)
        gl.deleteTexture(writeTarget.texture)
      }
      if (vertexArray) gl.deleteVertexArray(vertexArray)
      if (simulationProgram) gl.deleteProgram(simulationProgram)
      if (displayProgram) gl.deleteProgram(displayProgram)
    }
  }, [contextVersion])

  return (
    <div aria-hidden className="ct-agent-reasoning-ultra-layer" data-exiting={isExiting || undefined}>
      {isUnavailable ? (
        <div className="ct-agent-reasoning-ultra-fallback" />
      ) : (
        <canvas className="ct-agent-reasoning-ultra-canvas" ref={canvasRef} />
      )}
    </div>
  )
}
