"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, FileText, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";

export default function EntryPage() {
  const router = useRouter();
  const { status, startDemo } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "authenticated") router.replace("/");
  }, [status, router]);

  async function open() {
    setBusy(true);
    setError(null);

    try {
      await startDemo();
      router.replace("/");
    } catch (caught) {
      setError((caught as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="entry">
      <div className="entry-pitch">
        <div className="brand">
          <span className="brand-mark">
            <FileText size={14} />
          </span>
          docflow
        </div>
        <a className="language-link" href="https://docflow-web-woad.vercel.app" target="_blank" rel="noreferrer">
          English version ↗
        </a>

        <h1>票据入账前，先完成识别、校验与人工审核。</h1>

        <p>
          上传票据后，系统提取字段并定位每个值对应的原文，通过代码规则完成校验；任何不确定项都会交给人工处理。只有审核通过的版本才能同步到财务系统，重复提交也只会生成一张账单。
        </p>

        <ul className="facts">
          <li>
            <span className="num">$0.0007</span>
            <span>识别一张票据的实测模型成本，按调用记录而非估算</span>
          </li>
          <li>
            <span className="num">9 of 9</span>
            <span>9 个字段均可回溯到票据原文位置</span>
          </li>
          <li>
            <span className="num">1 张账单</span>
            <span>即使远端成功但响应丢失，重试也不会重复创建</span>
          </li>
          <li>
            <span className="num">0</span>
            <span>未经人工审核具体版本便同步的记录</span>
          </li>
        </ul>
      </div>

      <div className="entry-action">
        <h2 style={{ margin: 0, fontSize: 18 }}>打开演示工作空间</h2>
        <p style={{ margin: 0, color: "var(--ink-dim)", fontSize: 13.5 }}>
          无需注册，自动创建独立空间并在 24 小时后清理。内置 6 张合成票据，分别展示正常、重复、金额不一致、不支持币种、未来日期与提示词注入等场景。
        </p>

        <button className="primary" style={{ height: 40 }} onClick={open} disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : null}
          开始体验
          {!busy && <ArrowRight size={16} />}
        </button>

        {error && <p className="error-text">{error}</p>}

        <p className="note">
          演示中的模型调用与成本统计均为真实数据，因此空间会定期清理，页面角落显示的数值来自实际记录。
        </p>
      </div>
    </div>
  );
}
