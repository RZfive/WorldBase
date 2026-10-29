use std::path::{Path, PathBuf};
use worldbase_coding::{plan_write_batches, PlannedWrite, WriteBatch};

fn write(path: &str, depends_on: &[&str]) -> PlannedWrite {
    PlannedWrite {
        file_path: PathBuf::from(path),
        depends_on: depends_on.iter().map(PathBuf::from).collect(),
    }
}

fn batch_paths(batches: &[WriteBatch]) -> Vec<Vec<&Path>> {
    batches
        .iter()
        .map(|batch| {
            batch
                .edits
                .iter()
                .map(|edit| edit.file_path.as_path())
                .collect()
        })
        .collect()
}

#[test]
fn empty_input_produces_no_batches() {
    assert!(plan_write_batches(Vec::new()).is_empty());
}

#[test]
fn independent_writes_share_one_batch_in_deterministic_path_order() {
    let batches = plan_write_batches(vec![
        write("src/z.ts", &[]),
        write("src/a.ts", &[]),
        write("src/m.ts", &[]),
    ]);

    assert_eq!(
        batch_paths(&batches),
        vec![vec![
            Path::new("src/a.ts"),
            Path::new("src/m.ts"),
            Path::new("src/z.ts"),
        ]]
    );
}

#[test]
fn same_file_writes_are_serialized_in_original_order() {
    let batches = plan_write_batches(vec![
        write("src/a.ts", &[]),
        write("src/b.ts", &[]),
        write("./src/a.ts", &[]),
        write("src/a.ts", &[]),
    ]);

    assert_eq!(
        batch_paths(&batches),
        vec![
            vec![Path::new("src/a.ts"), Path::new("src/b.ts")],
            vec![Path::new("./src/a.ts")],
            vec![Path::new("src/a.ts")],
        ]
    );
}

#[test]
fn dependencies_are_ordered_before_dependents() {
    let batches = plan_write_batches(vec![
        write("src/app.ts", &["src/lib.ts"]),
        write("src/lib.ts", &[]),
    ]);

    assert_eq!(
        batch_paths(&batches),
        vec![vec![Path::new("src/lib.ts")], vec![Path::new("src/app.ts")],]
    );
}

#[test]
fn dependents_wait_for_every_write_to_a_dependency() {
    let batches = plan_write_batches(vec![
        write("src/lib.ts", &[]),
        write("src/app.ts", &["src/lib.ts"]),
        write("./src/lib.ts", &[]),
    ]);

    assert_eq!(
        batch_paths(&batches),
        vec![
            vec![Path::new("src/lib.ts")],
            vec![Path::new("./src/lib.ts")],
            vec![Path::new("src/app.ts")],
        ]
    );
}

#[test]
fn diamond_dependencies_produce_layered_batches() {
    let batches = plan_write_batches(vec![
        write("src/a.ts", &[]),
        write("src/b.ts", &[]),
        write("src/c.ts", &["src/a.ts", "src/b.ts"]),
        write("src/d.ts", &["src/c.ts"]),
    ]);

    assert_eq!(
        batch_paths(&batches),
        vec![
            vec![Path::new("src/a.ts"), Path::new("src/b.ts")],
            vec![Path::new("src/c.ts")],
            vec![Path::new("src/d.ts")],
        ]
    );
}

#[test]
fn cycles_are_serialized_deterministically_without_deadlock() {
    let batches = plan_write_batches(vec![
        write("src/b.ts", &["src/a.ts"]),
        write("src/a.ts", &["src/b.ts"]),
    ]);

    assert_eq!(
        batch_paths(&batches),
        vec![vec![Path::new("src/a.ts")], vec![Path::new("src/b.ts")],]
    );
}

#[test]
fn unknown_dependencies_are_ignored() {
    let batches = plan_write_batches(vec![
        write("src/app.ts", &["src/missing.ts", "react"]),
        write("src/lib.ts", &[]),
    ]);

    assert_eq!(
        batch_paths(&batches),
        vec![vec![Path::new("src/app.ts"), Path::new("src/lib.ts")]]
    );
}

#[test]
fn output_is_stable_for_repeated_and_shuffled_independent_input() {
    let forward = plan_write_batches(vec![
        write("src/b.ts", &[]),
        write("src/a.ts", &[]),
        write("src/c.ts", &[]),
    ]);
    let repeated = plan_write_batches(vec![
        write("src/b.ts", &[]),
        write("src/a.ts", &[]),
        write("src/c.ts", &[]),
    ]);
    let reversed = plan_write_batches(vec![
        write("src/c.ts", &[]),
        write("src/a.ts", &[]),
        write("src/b.ts", &[]),
    ]);

    assert_eq!(forward, repeated);
    assert_eq!(forward, reversed);
}

#[test]
fn edits_keep_their_dependency_metadata() {
    let batches = plan_write_batches(vec![write("src/app.ts", &["src/lib.ts"])]);
    assert_eq!(batches.len(), 1);
    assert_eq!(
        batches[0].edits[0].depends_on,
        vec![PathBuf::from("src/lib.ts")]
    );
}
