/** A generic textured-triangle renderer, independent of any animation Runtime. */
export function createTriangleRenderer(canvas, pages) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) throw Error('浏览器无法创建 WebGL 2，请使用支持 WebGL 2 的浏览器')
  const compile = (type, source) => {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader))
    return shader
  }
  const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
    in vec2 position; in vec2 uv; uniform vec4 view; out vec2 texUV;
    void main() { texUV=uv; gl_Position=vec4((position-view.xy)*view.zw,0.0,1.0); }`)
  const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float; in vec2 texUV; uniform sampler2D image;
    uniform vec4 tint; uniform bool pma; out vec4 pixel;
    void main() { vec4 t=texture(image,texUV); float a=t.a*tint.a;
      pixel=vec4(t.rgb*tint.rgb*(pma?tint.a:a),a); }`)
  const program = gl.createProgram()
  gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program))
  gl.deleteShader(vertex); gl.deleteShader(fragment)
  gl.useProgram(program)
  const posBuffer = gl.createBuffer(), uvBuffer = gl.createBuffer(), indexBuffer = gl.createBuffer()
  const attribute = (name, buffer) => {
    const at = gl.getAttribLocation(program, name)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.enableVertexAttribArray(at)
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0)
  }
  attribute('position', posBuffer); attribute('uv', uvBuffer)
  const view = gl.getUniformLocation(program, 'view'), tint = gl.getUniformLocation(program, 'tint'), pma = gl.getUniformLocation(program, 'pma')
  gl.uniform1i(gl.getUniformLocation(program, 'image'), 0)
  const textures = new Map()
  for (const [name, page] of pages) {
    if (Math.max(page.width, page.height) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw Error('贴图超出显卡支持的尺寸：' + name)
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, page.width, page.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(page.data.buffer, page.data.byteOffset, page.data.byteLength))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    textures.set(name, { texture, pma: !!page.pma })
  }
  gl.enable(gl.BLEND)
  let destroyed = false
  return {
    render(pose, camera, width, height, background = '#202020') {
      if (destroyed || gl.isContextLost()) throw Error('WebGL 上下文已失效，请重新选择动画')
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
      gl.viewport(0, 0, width, height)
      gl.clearColor(parseInt(background.slice(1, 3), 16) / 255, parseInt(background.slice(3, 5), 16) / 255, parseInt(background.slice(5, 7), 16) / 255, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(program)
      gl.uniform4f(view, camera.x, camera.y, 2 / (camera.height * width / height), 2 / camera.height)
      for (const draw of pose.draws) {
        if (!draw.positions.length || !draw.indices.length) continue
        const page = textures.get(draw.page)
        if (!page) throw Error('未加载贴图页 ' + draw.page)
        gl.bindTexture(gl.TEXTURE_2D, page.texture)
        gl.uniform1i(pma, page.pma ? 1 : 0)
        gl.uniform4fv(tint, draw.color)
        switch (draw.blend) {
          case 'additive': gl.blendFunc(gl.ONE, gl.ONE); break
          case 'multiply': gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA); break
          case 'screen': gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR); break
          default: gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer); gl.bufferData(gl.ARRAY_BUFFER, draw.positions, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer); gl.bufferData(gl.ARRAY_BUFFER, draw.uvs, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, draw.indices, gl.DYNAMIC_DRAW)
        gl.drawElements(gl.TRIANGLES, draw.indices.length, draw.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0)
      }
      const error = gl.getError()
      if (error !== gl.NO_ERROR) throw Error('WebGL 绘制失败：' + error)
    },
    pixels() {
      const result = new Uint8Array(canvas.width * canvas.height * 4)
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, result)
      if (gl.getError() !== gl.NO_ERROR) throw Error('读取视频帧失败')
      return result
    },
    dispose() {
      destroyed = true
      for (const page of textures.values()) gl.deleteTexture(page.texture)
      gl.deleteBuffer(posBuffer); gl.deleteBuffer(uvBuffer); gl.deleteBuffer(indexBuffer); gl.deleteProgram(program)
    },
  }
}
