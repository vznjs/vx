pub fn greet(name: &str) -> String {
    format!("hello, {name}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn greets_by_name() {
        assert_eq!(super::greet("vx"), "hello, vx");
    }
}
