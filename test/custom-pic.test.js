import { describe, expect, it } from 'vitest'
import { buildPicLoad, buildPicShow, defaultId, duplicateIds, validId } from '../src/custom-pic'

describe('custom-pic', () => {
  it('defaultId 去目录和扩展名并清理字符', () => {
    expect(defaultId('test.png')).toBe('test')
    expect(defaultId('sub/my pic-1.PNG')).toBe('my_pic_1')
    expect(defaultId('中文.png')).toBe('pic')
  })
  it('validId', () => {
    expect(validId('a_1')).toBe(true)
    expect(validId('a b')).toBe(false)
    expect(validId('')).toBe(false)
  })
  it('buildPicLoad', () => {
    expect(buildPicLoad('t1', 'test.png')).toBe('PIC_LOAD t1 test.png')
    expect(buildPicLoad('t1', 'sub/a.png', 10, -5)).toBe('PIC_LOAD t1 sub/a.png 10 -5')
    expect(buildPicLoad('t1', 'a b.png')).toBeNull()
  })
  it('buildPicShow', () => {
    expect(buildPicShow('&1', 't1')).toBe('PIC &1 t1')
    expect(buildPicShow('', 't1', ' f ')).toBe('PIC &1 t1 f')
  })
  it('duplicateIds', () => {
    expect([...duplicateIds(['a', 'b', 'a', 'a'])]).toEqual(['a'])
  })
})

import { GAME_WIDTHS, buildScript, dragToPos, gameHeight, placeInScreen, resolutionLabel } from '../src/custom-pic'
describe('game screen', () => {
  it('分辨率选项都是 16:9（整数除法）', () => {
    expect(GAME_WIDTHS).toHaveLength(15)
    expect(gameHeight(1280)).toBe(720)
    expect(gameHeight(1768)).toBe(994)
    expect(resolutionLabel(2560)).toBe('2560x1440（推荐）')
    expect(resolutionLabel(1920)).toBe('1920x1080')
  })
  it('placeInScreen：y 向上为正，缩放', () => {
    expect(placeInScreen(640, 360)).toEqual({ width: 50, height: 50, left: 50, top: 50 })
    expect(placeInScreen(1280, 720, 128, 72)).toEqual({ width: 100, height: 100, left: 60, top: 40 })
    expect(placeInScreen(640, 360, 0, 0, 2)).toEqual({ width: 100, height: 100, left: 50, top: 50 })
  })
  it('dragToPos', () => {
    expect(dragToPos(0, 0, 10, 10)).toEqual({ x: 128, y: -72 })
    expect(dragToPos(5, 5, 0, 0)).toEqual({ x: 5, y: 5 })
    expect(dragToPos(0, 0, 500, 0).x).toBe(1280)
  })
  it('buildScript', () => {
    expect(buildScript({ id: 't', rel: 'a.png' })).toEqual(['PIC_LOAD t a.png', 'PIC &1 t'])
    expect(buildScript({ id: 't', rel: 'a.png', x: -30, y: 12, scale: 2 })).toEqual(['PIC_LOAD t a.png', 'PIC &1 t', 'PIC_MV &1 -30 12 0', 'PIC_MVA &1 ZOOM2 0'])
    expect(buildScript({ id: 't', rel: 'a.png', scale: 0.5, extra: 'f' })[1]).toBe('PIC &1 t hf')
    expect(buildScript({ id: 't', rel: 'a.png', scale: 1.5 }).slice(1)).toEqual(['PIC &1 t h', 'PIC_MVA &1 ZOOM3 0'])
    expect(buildScript({ id: 't', rel: 'a b.png' })).toBeNull()
  })
})

import { sanitizeBase, uniqueBase, validFileBase } from '../src/custom-pic'
describe('file names', () => {
  it('sanitizeBase', () => {
    expect(sanitizeBase('My Pic (1).PNG')).toBe('My_Pic_1')
    expect(sanitizeBase('中文.png')).toBe('pic')
  })
  it('validFileBase', () => {
    expect(validFileBase('a-b_1')).toBe(true)
    expect(validFileBase('a b')).toBe(false)
    expect(validFileBase('a.b')).toBe(false)
  })
  it('uniqueBase', () => {
    expect(uniqueBase('a', ['b.png'])).toBe('a')
    expect(uniqueBase('a', ['a.png', 'A_1.png'])).toBe('a_2')
    expect(uniqueBase('a', ['sub/a.png'], 'sub/')).toBe('a_1')
  })
})
