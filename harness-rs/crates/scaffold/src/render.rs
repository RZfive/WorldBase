use std::collections::BTreeMap;

/// Minimal, dependency-free template renderer.
///
/// Supported syntax:
/// - `{{key}}`                    simple replacement
/// - `{{#each name}}...{{/each}}` block repeated for each map in a list
///
/// Within a block, keys are resolved against the current item first and then
/// against the global map, so `{{field}}` and `{{camel}}` both work as long as
/// the item declares them.
pub fn render(template: &str, vars: &BTreeMap<String, String>) -> String {
    render_scope(template, vars, &BTreeMap::new(), None)
}

pub fn render_with_items(
    template: &str,
    vars: &BTreeMap<String, String>,
    items: &BTreeMap<String, Vec<BTreeMap<String, String>>>,
) -> String {
    render_scope(template, vars, items, None)
}

fn render_scope(
    template: &str,
    vars: &BTreeMap<String, String>,
    items: &BTreeMap<String, Vec<BTreeMap<String, String>>>,
    item: Option<&BTreeMap<String, String>>,
) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{#each ") {
        out.push_str(&render_placeholders(&rest[..start], vars, item));
        let after = &rest[start + "{{#each ".len()..];
        let Some(name_end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let list_name = after[..name_end].trim();
        let body_start = name_end + 2;
        let Some(end) = find_each_end(&after[body_start..]) else {
            out.push_str(&rest[start..]);
            return out;
        };
        let body = &after[body_start..body_start + end];
        if let Some(list) = items.get(list_name) {
            for entry in list {
                out.push_str(&render_scope(body, vars, items, Some(entry)));
            }
        }
        rest = &after[body_start + end + "{{/each}}".len()..];
    }
    out.push_str(&render_placeholders(rest, vars, item));
    out
}

fn render_placeholders(
    template: &str,
    vars: &BTreeMap<String, String>,
    item: Option<&BTreeMap<String, String>>,
) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let key = after[..end].trim();
        let value = item
            .and_then(|entry| entry.get(key))
            .or_else(|| vars.get(key));
        if let Some(value) = value {
            out.push_str(value);
        } else {
            out.push_str(&rest[start..start + 2 + end + 2]);
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

fn find_each_end(text: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut index = 0usize;
    loop {
        let open = text[index..]
            .find("{{#each ")
            .map(|position| position + index);
        let close = text[index..]
            .find("{{/each}}")
            .map(|position| position + index);
        match (open, close) {
            (None, None) => return None,
            (Some(open), None) => {
                depth += 1;
                index = open + "{{#each ".len();
            }
            (None, Some(close)) => {
                if depth == 0 {
                    return Some(close);
                }
                depth -= 1;
                index = close + "{{/each}}".len();
            }
            (Some(open), Some(close)) => {
                if open < close {
                    depth += 1;
                    index = open + "{{#each ".len();
                } else {
                    if depth == 0 {
                        return Some(close);
                    }
                    depth -= 1;
                    index = close + "{{/each}}".len();
                }
            }
        }
    }
}

pub fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_simple_values_and_keeps_unknown_tags() {
        let values = vars(&[("name", "WorldBase")]);
        assert_eq!(
            render("hello {{name}} {{missing}}", &values),
            "hello WorldBase {{missing}}"
        );
    }

    #[test]
    fn each_blocks_resolve_item_fields_before_globals() {
        let values = vars(&[("suffix", "!")]);
        let mut first = BTreeMap::new();
        first.insert("field".into(), "title".into());
        let mut second = BTreeMap::new();
        second.insert("field".into(), "amount".into());
        let mut lists = BTreeMap::new();
        lists.insert("fields".to_string(), vec![first, second]);
        let output = render_with_items(
            "{{#each fields}}{{field}}{{suffix}} {{/each}}",
            &values,
            &lists,
        );
        assert_eq!(output, "title! amount! ");
    }

    #[test]
    fn nested_each_blocks_close_on_the_matching_tag() {
        let mut outer = BTreeMap::new();
        outer.insert("name".into(), "outer".into());
        let mut lists = BTreeMap::new();
        lists.insert("outer".to_string(), vec![outer]);
        let output = render_with_items(
            "{{#each outer}}{{name}}{{#each inner}}x{{/each}}{{/each}}",
            &BTreeMap::new(),
            &lists,
        );
        assert_eq!(output, "outer");
    }
}
