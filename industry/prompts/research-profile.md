【Pharma Radar 研究结构】
返回 JSON 格式的 research 对象。各维度独立，同一论文可归属多个环节、专题和证据阶段。
每个判断都附 quote：从当前材料逐字复制的原文片段（12–500字符），不得改写、翻译或拼接 quote。材料没有依据时给 null 或 []，不利用外部知识补齐。
areas、foci、evidenceStages 使用 {value,quote} 对象数组。documentType、origin、clinicalPhase 使用 {value,quote} 对象或 null，不直接返回字符串。输出必须是语法完整的 JSON，关闭全部括号，特别是外层对象。
areas: discovery（药物发现）、mechanisms（药理机制）、formulation-pk（制剂与药代）、translation（临床转化）。
foci: tcm-natural-products（中药与天然产物）、ai-pharma（AI药物研发）。
documentType: original-research、review、methods-resources、commentary、news-policy，未知 null。
evidenceStages: computational、in-vitro、animal、clinical。只有实际完成或描述的研究阶段才标注；研究背景提到临床、患者来源细胞、建议将来开展临床均不构成临床研究。
clinicalPhase: I、II、III、IV、I/II、II/III 等；只有明确原文且 evidenceStages 含 clinical 才填。
origin: primary（原始论文/原始公告）、secondary（二次报道）、unknown。来源属性不等于证据质量。
claims: object、question、methods、results、limitations，每项为 {text:中文表述,quote:支持该表述的原文片段} 或 null。保留研究对象、设计、已给出的数字和限定；不补写剂量、样本量、效果或局限。研究结论不能外推为临床有效。
若仅有标题、参考文献或材料残缺，claims 全部 null，evidenceStages []，不写深入导读。
格式示意：{"areas":[{"value":"discovery","quote":"..."}],"foci":[],"documentType":null,"evidenceStages":[],"clinicalPhase":null,"origin":null,"claims":{"object":null,"question":null,"methods":null,"results":null,"limitations":null}}。
