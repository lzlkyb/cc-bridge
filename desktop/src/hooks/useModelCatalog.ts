/**
 * 上游模型目录：一次会话内的临时事实，不落盘、不进草稿。
 *
 * 单独一个 hook 而不是塞进 `useRelayDraft`：表单草稿的生命周期是「跟随服务端 +
 * 失焦保存」，模型列表的生命周期是「点一次按钮取一次」，两者混在一个 hook 里
 * 会让状态数很快顶到体量门禁，也会让「指纹跟随」逻辑多一类无关字段。
 */

import { useCallback, useState } from "react";
import { invoke } from "../lib/tauri";
import type { RelayAuthStyle } from "./useRelayDraft";

export function useModelCatalog(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  authStyle: RelayAuthStyle;
  profileId: string;
  onError: (message: string) => void;
}) {
  const { baseUrl, apiKey, model, authStyle, profileId, onError } = params;
  const [models, setModels] = useState<string[]>([]);
  const [listing, setListing] = useState(false);

  /**
   * 问上游要模型列表。
   *
   * 失败只把错误交给表单，**不回退成上次的结果**——用户点这一下就是想确认
   * 「现在填的地址与密钥能看到什么」，拿旧列表顶替等于骗他。
   */
  const fetchModels = useCallback(async (): Promise<string[] | null> => {
    if (listing) return null;
    setListing(true);
    onError("");
    try {
      const list = await invoke<string[]>("relay_list_models", {
        draft: {
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          model: model.trim(),
          authStyle,
          profileId,
        },
      });
      setModels(list);
      return list;
    } catch (e) {
      onError(String(e));
      return null;
    } finally {
      setListing(false);
    }
  }, [apiKey, authStyle, baseUrl, listing, model, onError, profileId]);

  return { models, listing, fetchModels };
}
