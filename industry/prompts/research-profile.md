【Pharma Radar 研究结构】
返回 JSON 格式的 research 对象。各维度独立，同一论文可归属多个环节、专题和证据阶段。
每个判断都附 quote：从当前材料逐字复制的原文片段（12–500字符），不得改写、翻译或拼接 quote。材料没有依据时给 null 或 []，不利用外部知识补齐。
quote 超过 500 字符会被整体拒收。选取完整的短句作为依据，不用超长整段。一个字段只概括该片段支持的事实；结果片段保留比较符号、统计值和限定。数字必须存在于对应 quote 中。
quote 目标长度为 60–250 字符；每个 claims.text 只写其配对 quote 的信息，不混入其他段落。多项结果无法由一个短片段支持时，选择最核心的一组结果，不把全文各处数字塞入同一字段。元数据已给出文献类型或来源性质时 documentType、origin 可返回 null，由系统读取元数据。
短片段示例（格式示范，不是本篇材料）：若原文为 “The model achieved 92% balanced accuracy on the capsaicin dataset.”，results 可写“该数据集的平衡准确率为92%。”，quote 使用该句；不能额外写来自另一段的相关系数或外部验证数字。
areas、foci、evidenceStages 使用 {value,quote} 对象数组。documentType、origin、clinicalPhase 使用 {value,quote} 对象或 null，不直接返回字符串。输出必须是语法完整的 JSON，关闭全部括号，特别是外层对象。
areas: discovery（药物发现）、mechanisms（药理机制）、formulation-pk（制剂与药代）、translation（临床转化）。
foci: tcm-natural-products（中药与天然产物）、ai-pharma（AI药物研发）。
天然产物须明确关联药物、药理或疾病研究；仅农业、食品、生态用途排除。用能识别天然来源、植物提取物或中药的片段支持此专题。AI 专题须在材料中实质应用 AI、机器学习、深度学习或开发药研工具；对接、计算设计本身不是 AI，仅在展望中提及 AI 不归入专题。
documentType: original-research、review、methods-resources、commentary、news-policy，未知 null。
evidenceStages: computational、in-vitro、animal、clinical。只有实际完成或描述的研究阶段才标注；研究背景提到临床、患者来源细胞、建议将来开展临床均不构成临床研究。
计算包括深度学习模型、语言模型、虚拟筛选及计算基准。小鼠来源细胞不等于动物实验；患者数据回顾分析不等于临床试验。综述阶段只描述其涵盖的证据，不能写成这篇综述做了试验。
clinicalPhase: I、II、III、IV、I/II、II/III 等；只用于明确原文的原始临床研究，且 evidenceStages 含 clinical；综述、预期临床与简讯留空。
origin: primary（原始论文/原始公告）、secondary（二次报道）、unknown。来源属性不等于证据质量。
claims: object、question、methods、results、limitations，每项为 {text:中文表述,quote:支持该表述的原文片段} 或 null。保留研究对象、设计、已给出的数字和限定；不补写剂量、样本量、效果或局限。研究结论不能外推为临床有效。
原始研究优先提取 object、methods、results 三项；缺项不会标为导读就绪。综述必须有对象和综述要点（放入 results），methods 只写材料提供的检索或综合方法。文献计量的发文趋势、热点不能改写为新验证的药效结果。
“摘要没有报告局限”“全文待核对”等是本站材料范围，不是来源中的研究结论；limitations 留空，除非来源片段明确交代研究局限。专有名词无可靠中文对应时保留原英文、化合物名或学名，不猜中文药名。期刊 News、Research Highlight 是二次报道，保留简讯自身 DOI；不冒充被报道的原始论文。
若仅有标题、参考文献或材料残缺，claims 全部 null，evidenceStages []，不写深入导读。
格式示意：{"areas":[{"value":"discovery","quote":"..."}],"foci":[],"documentType":null,"evidenceStages":[],"clinicalPhase":null,"origin":null,"claims":{"object":null,"question":null,"methods":null,"results":null,"limitations":null}}。
