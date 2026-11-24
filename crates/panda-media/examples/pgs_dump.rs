fn main() {
    let data = std::fs::read(std::env::args().nth(1).unwrap()).unwrap();
    for (i, c) in panda_media::pgs::parse(&data).iter().enumerate().take(8) {
        println!("{i} {:?}", (c.start, c.end));
    }
}
