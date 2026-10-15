import { describe, expect, it } from "vitest";
import { parseSavedSize, MIN_WIDTH, MIN_HEIGHT, WINDOW_SIZE_KEY } from "./windowState";

describe("parseSavedSize", () => {
  it("合法值原样通过（整型）", () => {
    expect(parseSavedSize('{"width":1280,"height":840}')).toEqual({
      width: 1280,
      height: 840,
    });
  });

  it("浮点值向下取整", () => {
    expect(parseSavedSize('{"width":1280.9,"height":840.2}')).toEqual({
      width: 1280,
      height: 840,
    });
  });

  it("null / 空串返回 null", () => {
    expect(parseSavedSize(null)).toBeNull();
    expect(parseSavedSize("")).toBeNull();
  });

  it("非法 JSON 返回 null", () => {
    expect(parseSavedSize("not-json{")).toBeNull();
  });

  it("非对象字段类型返回 null", () => {
    expect(parseSavedSize('{"width":"1280","height":840}')).toBeNull();
    expect(parseSavedSize('{"width":true,"height":840}')).toBeNull();
    expect(parseSavedSize('{"height":840}')).toBeNull();
    expect(parseSavedSize('{"width":1280}')).toBeNull();
    expect(parseSavedSize('{"width":NaN,"height":840}')).toBeNull();
  });

  it("低于 minWidth/minHeight 视为非法（与 tauri.conf 一致）", () => {
    expect(parseSavedSize(`{"width":${MIN_WIDTH - 1},"height":840}`)).toBeNull();
    expect(parseSavedSize(`{"width":1280,"height":${MIN_HEIGHT - 1}}`)).toBeNull();
    expect(parseSavedSize(`{"width":${MIN_WIDTH},"height":${MIN_HEIGHT}}`)).toEqual({
      width: MIN_WIDTH,
      height: MIN_HEIGHT,
    });
  });

  it("超上限（localStorage 污染兜底）返回 null", () => {
    expect(parseSavedSize('{"width":99999,"height":840}')).toBeNull();
    expect(parseSavedSize('{"width":1280,"height":99999}')).toBeNull();
  });

  it("额外字段不影响解析", () => {
    expect(parseSavedSize('{"width":1280,"height":840,"x":10,"y":20}')).toEqual({
      width: 1280,
      height: 840,
    });
  });

  it("键名常量不被误改（防与其他 localStorage 键冲突）", () => {
    expect(WINDOW_SIZE_KEY).toBe("cc-bridge.window.size.v1");
  });
});
