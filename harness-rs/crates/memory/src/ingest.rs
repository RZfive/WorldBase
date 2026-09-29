//! Conservative extraction of explicit user preference statements. Questions,
//! examples, quotations and hypothetical instructions are not personal facts.

pub(crate) fn explicit_preferences(message: &str) -> Vec<String> {
    if ["```", "比如", "例如", "假设", "如果", "假如", "引用"]
        .iter()
        .any(|word| message.contains(word))
    {
        return Vec::new();
    }
    let expression = regex::Regex::new(
        r"^(?:请(?:你)?(?:记住|记下)[，,：:\s]*)?我(?:更|最|很)?(?:不喜欢|喜欢|偏好|讨厌|爱吃|爱喝|习惯)([^，,。；;！？?\n]{1,80})[。！!]?$"
    ).unwrap();
    message
        .split_inclusive(['\n', '。', '！', '!', '？', '?'])
        .filter_map(|sentence| {
            let sentence = sentence.trim();
            if [
                "?",
                "？",
                "什么",
                "哪些",
                "吗",
                "是否",
                "比如",
                "例如",
                "假设",
                "如果",
                "假如",
                "是不是",
                "对不对",
                "还是",
            ]
            .iter()
            .any(|word| sentence.contains(word))
            {
                return None;
            }
            expression.captures(sentence)?;
            let start = sentence.find('我')?;
            Some(format!(
                "用户{}",
                sentence[start + '我'.len_utf8()..].trim_end_matches(['。', '！', '!'])
            ))
        })
        .collect()
}

pub(crate) fn is_recall_report(text: &str) -> bool {
    let text = text.to_lowercase();
    text.contains("memory_search")
        || ((text.contains("记忆") || text.contains("偏好"))
            && [
                "没有记录",
                "没有任何",
                "未找到",
                "没有找到",
                "无法确认",
                "未保存",
                "尚未记录",
            ]
            .iter()
            .any(|word| text.contains(word)))
        || [
            "no memories",
            "no stored",
            "do not remember",
            "don't remember",
        ]
        .iter()
        .any(|word| text.contains(word))
}
